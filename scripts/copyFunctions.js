const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'src', 'functions');
const destination = path.join(__dirname, '..', 'dist', 'functions');

if (!fs.existsSync(source)) {
  process.exit(0);
}

fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
