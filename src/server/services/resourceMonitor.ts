import fs from 'node:fs';
import os from 'node:os';
import { CONFIG } from '../config.ts';
import { getDb, getHubSettings } from '../db/database.ts';
import type { ResourceSnapshot } from '../../shared/types.ts';

let activeModelName: string | null = null;
let modelLoadingStatus: 'idle' | 'loading' | 'active' = 'idle';
let schedulerPausedFlag = false;
let prevCpuSample = sampleCpu();

function sampleCpu(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function measureCpuPercent(): number {
  const next = sampleCpu();
  const idleDelta = next.idle - prevCpuSample.idle;
  const totalDelta = next.total - prevCpuSample.total;
  prevCpuSample = next;
  if (totalDelta <= 0) {
    const load1 = os.loadavg()[0] || 0;
    const cores = Math.max(1, os.cpus().length);
    return Math.min(100, Math.round((load1 / cores) * 100));
  }
  const usage = 100 - (idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(usage)));
}

function measureDiskGb(): { freeGb: number | null; totalGb: number | null } {
  try {
    const stat = fs.statfsSync(CONFIG.rootDir);
    const totalGb = Number(((stat.blocks * stat.bsize) / (1024 ** 3)).toFixed(1));
    const freeGb = Number(((stat.bavail * stat.bsize) / (1024 ** 3)).toFixed(1));
    return { freeGb, totalGb };
  } catch {
    return { freeGb: null, totalGb: null };
  }
}

export function setActiveModelState(model: string | null, status: 'idle' | 'loading' | 'active'): void {
  activeModelName = model;
  modelLoadingStatus = status;
}

export function setSchedulerPaused(paused: boolean): void {
  schedulerPausedFlag = paused;
}

export function isSchedulerPaused(): boolean {
  return schedulerPausedFlag;
}

export function getResourceSnapshot(): ResourceSnapshot {
  const db = getDb();
  const settings = getHubSettings();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memoryUsedPercent = Math.round((usedMem / Math.max(1, totalMem)) * 100);
  const cpuLoadPercent = measureCpuPercent();
  const disk = measureDiskGb();
  const cpus = os.cpus();

  const counts = db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running_cnt,
        SUM(CASE WHEN status IN ('queued', 'pending') THEN 1 ELSE 0 END) as queued_cnt,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused_cnt
       FROM agent_tasks`,
    )
    .get() as { running_cnt: number | null; queued_cnt: number | null; paused_cnt: number | null };

  let resourcePressure: 'nominal' | 'elevated' | 'critical' = 'nominal';
  if (
    memoryUsedPercent >= settings.resourceLimits.maxMemoryPercent ||
    cpuLoadPercent >= settings.resourceLimits.maxCpuPercent
  ) {
    resourcePressure = 'critical';
  } else if (
    memoryUsedPercent >= settings.resourceLimits.maxMemoryPercent - 12 ||
    cpuLoadPercent >= settings.resourceLimits.maxCpuPercent - 15
  ) {
    resourcePressure = 'elevated';
  }

  return {
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    nodeVersion: process.version,
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model || 'Unknown CPU',
    cpuLoadPercent,
    memoryTotalMb: Math.round(totalMem / (1024 * 1024)),
    memoryUsedMb: Math.round(usedMem / (1024 * 1024)),
    memoryUsedPercent,
    diskFreeGb: disk.freeGb,
    diskTotalGb: disk.totalGb,
    activeModel: activeModelName,
    modelLoadingStatus,
    runningTasks: counts?.running_cnt || 0,
    queuedTasks: counts?.queued_cnt || 0,
    pausedTasks: counts?.paused_cnt || 0,
    maxConcurrentAgents: settings.resourceLimits.maxConcurrentAgents,
    resourcePressure,
    schedulerPaused: schedulerPausedFlag,
    timestamp: new Date().toISOString(),
  };
}

export function canAcceptTask(priority: number): { allowed: boolean; reason?: string } {
  const snap = getResourceSnapshot();
  if (snap.schedulerPaused) {
    return { allowed: false, reason: 'Scheduler is paused by operator' };
  }
  if (snap.runningTasks >= snap.maxConcurrentAgents) {
    return {
      allowed: false,
      reason: `Concurrency limit reached (${snap.runningTasks}/${snap.maxConcurrentAgents})`,
    };
  }
  if (snap.resourcePressure === 'critical' && priority > 2) {
    return {
      allowed: false,
      reason: `System resources under pressure (RAM ${snap.memoryUsedPercent}%, CPU ${snap.cpuLoadPercent}%) — deferring low-priority task`,
    };
  }
  return { allowed: true };
}
