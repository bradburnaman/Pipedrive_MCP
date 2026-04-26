import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './path-safety.js';

interface ConfigJson {
  setupAt?: string;
  nextRotationDue?: string;
  writes_enabled?: boolean;
}

export class KillSwitch {
  private _writesEnabled: boolean;
  private path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? join(configDir(), 'config.json');
    const cfg: ConfigJson = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as ConfigJson)
      : {};
    this._writesEnabled = cfg.writes_enabled ?? true;
  }

  // Re-read on every check so the CLI (a separate process) can flip the
  // switch without restarting the running server. The cached value is the
  // fallback when the file is unreadable.
  get writesEnabled(): boolean {
    if (!existsSync(this.path)) return this._writesEnabled;
    try {
      const cfg = JSON.parse(readFileSync(this.path, 'utf8')) as ConfigJson;
      const persisted = cfg.writes_enabled ?? true;
      this._writesEnabled = persisted;
      return persisted;
    } catch {
      return this._writesEnabled;
    }
  }

  setWritesEnabled(enabled: boolean): void {
    this._writesEnabled = enabled;
    const cfg: ConfigJson = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as ConfigJson)
      : {};
    cfg.writes_enabled = enabled;
    writeFileSync(this.path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
}
