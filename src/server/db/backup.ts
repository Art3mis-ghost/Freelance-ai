import path from 'node:path';
import { CONFIG, ensureDirectories } from '../config.ts';
import {
  createFullVerifiedBackup,
  exportEncryptedKeyBackup,
  restoreEncryptedKeyBackup,
} from '../services/backupService.ts';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  ensureDirectories();

  if (hasFlag('--restore-key')) {
    const keyFile = getArg('--restore-key');
    const passphrase = getArg('--passphrase') || process.env.HUB_KEY_BACKUP_PASSPHRASE || '';
    if (!keyFile) {
      console.error('[ERROR] Usage: tsx src/server/db/backup.ts --restore-key <path> --passphrase <passphrase>');
      process.exit(1);
    }
    if (!passphrase) {
      console.error('[ERROR] Provide recovery passphrase via --passphrase or HUB_KEY_BACKUP_PASSPHRASE env var.');
      process.exit(1);
    }
    const restored = restoreEncryptedKeyBackup(path.resolve(keyFile), passphrase);
    console.log(
      JSON.stringify(
        {
          ok: true,
          keySource: restored.keySource,
          exportedAt: restored.exportedAt,
          fingerprintSha256Prefix: restored.fingerprintSha256Prefix,
          HUB_SECRET_ENCRYPTION_KEY: restored.encryptionKey,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (hasFlag('--key-only')) {
    const passphrase = getArg('--passphrase') || process.env.HUB_KEY_BACKUP_PASSPHRASE || '';
    if (!passphrase) {
      console.error(
        '[ERROR] Exporting an encrypted key backup requires a recovery passphrase (>= 12 chars) via --passphrase or HUB_KEY_BACKUP_PASSPHRASE.',
      );
      process.exit(1);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath =
      getArg('--output') ||
      path.join(CONFIG.backupsDir, `FreelanceAgentHub_KeyBackup_${stamp}.keybackup.enc.json`);
    const exported = exportEncryptedKeyBackup(passphrase, path.resolve(outPath));
    console.log(JSON.stringify({ ok: true, ...exported }, null, 2));
    return;
  }

  const outZip = getArg('--output');
  const result = await createFullVerifiedBackup({
    outputArchivePath: outZip ? path.resolve(outZip) : undefined,
  });

  if (hasFlag('--json')) {
    console.log(
      JSON.stringify({
        ok: true,
        archivePath: result.archivePath,
        archiveSizeBytes: result.archiveSizeBytes,
        archiveSha256: result.archiveSha256,
        backupMethod: result.manifest.database.backupMethod,
        integrityCheck: result.manifest.database.verification.integrityCheck,
        foreignKeyViolations: result.manifest.database.verification.foreignKeyViolations,
        projectsCount: result.manifest.includedArtifacts.projectsCount,
        runtimeLogsCount: result.manifest.includedArtifacts.runtimeLogsIncluded.length,
      }),
    );
  } else {
    console.log(`[OK] Consistent SQLite backup created and verified: ${result.archivePath}`);
    console.log(`     Method: ${result.manifest.database.backupMethod}`);
    console.log(
      `     Integrity Check: ${result.manifest.database.verification.integrityCheck} | FK Violations: ${result.manifest.database.verification.foreignKeyViolations}`,
    );
    console.log(
      `     Projects: ${result.manifest.includedArtifacts.projectsCount} | Logs: ${result.manifest.includedArtifacts.runtimeLogsIncluded.length} | Size: ${(result.archiveSizeBytes / 1024).toFixed(1)} KB`,
    );
    console.log(`     SHA-256: ${result.archiveSha256}`);
    console.log(
      '     Note: Encryption key is excluded from the ZIP archive. Run "npm run backup:key -- --passphrase <passphrase>" to create a separately encrypted key backup.',
    );
  }
}

main().catch((err) => {
  console.error(`[ERROR] Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
