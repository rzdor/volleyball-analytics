const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');

fs.mkdirSync(distRoot, { recursive: true });

// Copy host.json into dist for Azure Functions runtime
const hostFile = path.join(projectRoot, 'src', 'host.json');
if (fs.existsSync(hostFile)) {
  fs.cpSync(hostFile, path.join(distRoot, 'host.json'));
}

// Copy package files into dist for production dependency install
['package.json', 'package-lock.json'].forEach((fileName) => {
  const filePath = path.join(projectRoot, fileName);
  if (fs.existsSync(filePath)) {
    fs.cpSync(filePath, path.join(distRoot, fileName));
  }
});