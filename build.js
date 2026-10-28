const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Create dist directory
if (!fs.existsSync('dist')) fs.mkdirSync('dist');

const files = fs.readdirSync('.').filter(f =>
  f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')
);

let ok = 0, fail = 0;
for (const file of files) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const out = esbuild.transformSync(src, {
      loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
      target: 'node20',
      format: 'cjs',
      sourcemap: false,
    });
    fs.writeFileSync(path.join('dist', file.replace('.ts', '.js')), out.code);
    ok++;
  } catch (e) {
    console.error('FAIL: ' + file + ' - ' + e.message.slice(0, 120));
    fail++;
  }
}
console.log('Compiled: ' + ok + ' files, ' + fail + ' failures');
if (fail > 0) process.exit(1);
