const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(projectRoot, 'python');
const destinationDir = path.join(projectRoot, 'dist', 'python');

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Python source directory not found: ${sourceDir}`);
}

fs.rmSync(destinationDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
fs.cpSync(sourceDir, destinationDir, { recursive: true });

console.log(`Copied Python assets to ${destinationDir}`);
