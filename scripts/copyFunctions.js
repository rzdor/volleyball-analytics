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

fs.readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .forEach((entry) => {
    const sourceFunctionPath = path.join(source, entry.name);
    const configPath = path.join(sourceFunctionPath, 'function.json');
    if (!fs.existsSync(configPath)) {
      return;
    }

    const shimDir = path.join(distRoot, entry.name);
    fs.mkdirSync(shimDir, { recursive: true });
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to parse function.json for ${entry.name} at ${configPath}: ${message}. Verify that the file contains valid JSON.`,
      );
      throw error instanceof Error ? error : new Error(message);
    }

    const compiledDir = path.join(destination, entry.name);
    const compiledScript =
      (fs.existsSync(compiledDir)
        ? fs.readdirSync(compiledDir).find((file) => file.toLowerCase().endsWith('.js'))
        : undefined) || 'index.js';
    const compiledPath = path.join(compiledDir, compiledScript);
    if (!fs.existsSync(compiledPath)) {
      throw new Error(
        `Compiled script for function "${entry.name}" not found at ${compiledPath}. Ensure the project is built before packaging functions.`,
      );
    }
    config.scriptFile = './index.js';
    fs.writeFileSync(path.join(shimDir, 'function.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(
      path.join(shimDir, 'index.js'),
      `module.exports = require('../functions/${entry.name}/${compiledScript}');\n`,
    );
  });
