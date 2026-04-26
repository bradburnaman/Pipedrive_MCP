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

  get writesEnabled(): boolean { return this._writesEnabled; }

  setWritesEnabled(enabled: boolean): void {
    this._writesEnabled = enabled;
    const cfg: ConfigJson = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as ConfigJson)
      : {};
    cfg.writes_enabled = enabled;
    writeFileSync(this.path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
}
