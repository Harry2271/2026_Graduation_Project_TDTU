// postinstall-hoist-next.js
// ---------------------------------------------------------------------------
// Workaround for Next.js 16 + eslint-config-next + monorepo (yarn 1 workspaces).
//
// eslint-config-next@16.x is hoisted to <repo>/node_modules/ by yarn 1. At
// import time, its dist/parser.js does `require("next/dist/compiled/babel/eslint-parser")`.
// Node resolves that require by walking up from the parser.js location looking
// for a `next` package. Because yarn 1 cannot hoist `next` to the root (blocked
// by transitive conflicts with the mobile workspace's react@19.2.0), the
// `next` package lives at apps/web/node_modules/next/ instead, and the require
// fails with `Cannot find module 'next/dist/compiled/babel/eslint-parser'`.
//
// This script creates a junction at <repo>/node_modules/next that points to
// apps/web/node_modules/next so the require succeeds. It is idempotent and
// safe to run on every install. It never deletes anything; if a real `next`
// directory already exists at root, the script leaves it alone.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const target = path.join(repoRoot, 'node_modules', 'next');
const source = path.join(repoRoot, 'apps', 'web', 'node_modules', 'next');

function log(msg) {
  console.log(`[postinstall-hoist-next] ${msg}`);
}

try {
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      log(`root/node_modules/next already exists, skipping (${stat.isSymbolicLink() ? 'symlink' : 'directory'})`);
      process.exit(0);
    }
  }

  if (!fs.existsSync(source)) {
    log(`apps/web/node_modules/next not found, nothing to hoist (web app may not be installed yet)`);
    process.exit(0);
  }

  fs.symlinkSync(source, target, 'junction');
  log(`created junction: root/node_modules/next -> apps/web/node_modules/next`);
} catch (err) {
  // Never fail the install because of a symlink issue.
  console.error(`[postinstall-hoist-next] symlink failed: ${err.message}`);
  console.error('[postinstall-hoist-next] if web lint still fails, run this manually:');
  console.error('  node scripts/postinstall-hoist-next.js');
  process.exit(0);
}
