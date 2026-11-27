import { ensureDirectories, CONFIG } from '../config.ts';
import { initDatabase, closeDatabase } from './database.ts';

ensureDirectories();
initDatabase();
console.log(`Initialized SQLite database at ${CONFIG.dbPath}`);
console.log(`Workspace directory ready at ${CONFIG.workspaceDir}`);
closeDatabase();
