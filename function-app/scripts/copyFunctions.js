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

// Create per-function folders in dist with compiled code and service dependencies
const compiledFunctionsDir = path.join(distRoot, 'src', 'functions');
const compiledServicesDir = path.join(distRoot, 'src', 'services');

if (fs.existsSync(compiledFunctionsDir)) {
  const functionFiles = fs.readdirSync(compiledFunctionsDir).filter((f) => f.endsWith('.js'));

  functionFiles.forEach((fileName) => {
    const funcName = path.basename(fileName, '.js');
    const funcDir = path.join(distRoot, funcName);

    fs.mkdirSync(funcDir, { recursive: true });

    // Copy compiled function file, fixing relative service import paths
    const srcCode = fs.readFileSync(path.join(compiledFunctionsDir, fileName), 'utf8');
    const fixedCode = srcCode.replace(/require\("\.\.\/services\//g, 'require("./services/');
    fs.writeFileSync(path.join(funcDir, 'index.js'), fixedCode, 'utf8');

    // Copy services into the function folder
    if (fs.existsSync(compiledServicesDir)) {
      fs.cpSync(compiledServicesDir, path.join(funcDir, 'services'), { recursive: true });
    }
  });
}