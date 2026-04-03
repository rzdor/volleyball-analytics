import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import videoRoutes from './routes/videoRoutes';
import { getProjectInfo } from './projectInfo';

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directories exist
const uploadsInputDir = path.join(process.cwd(), 'uploads/inputs');
const uploadsProcessedDir = path.join(process.cwd(), 'uploads/processed');
fs.mkdirSync(uploadsInputDir, { recursive: true });
fs.mkdirSync(uploadsProcessedDir, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/videos', videoRoutes);
app.get('/api/project-info', (req, res) => {
  res.json(getProjectInfo());
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/videos/:recordId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/video.html'));
});

app.get('/videos/:recordId/players', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/players.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
