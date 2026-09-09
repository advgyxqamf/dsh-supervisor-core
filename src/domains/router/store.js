'use strict';

// RouterStore: smart router persistence.
const fs = require('node:fs');
const path = require('node:path');

class RouterStore {
  constructor(opts) { this.file = opts.file; }
  load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { providers: Array.isArray(doc.providers) ? doc.providers : [] };
    } catch { return { providers: [] }; }
  }
  save(providers) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ providers: providers.map((p) => p.serialize()) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { RouterStore };
