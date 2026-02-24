const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const source = path.join(projectRoot, 'src', 'functions');
const destination = path.join(projectRoot, 'dist', 'functions');

if (!fs.existsSync(source)) {
  process.exit(0);
}

const distRoot = path.join(projectRoot, 'dist');
fs.mkdirSync(distRoot, { recursive: true });
fs.cpSync(source, destination, { recursive: true });

const hostFile = path.join(projectRoot, 'src', 'host.json');
if (fs.existsSync(hostFile)) {
  fs.cpSync(hostFile, path.join(distRoot, 'host.json'));
}

['package.json', 'package-lock.json'].forEach((fileName) => {
  const filePath = path.join(projectRoot, fileName);
  if (fs.existsSync(filePath)) {
    fs.cpSync(filePath, path.join(distRoot, fileName));
  }
});