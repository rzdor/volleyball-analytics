import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import videoRoutes from './routes/videoRoutes';

const app = express();
const PORT = process.env.PORT || 3000;
const uploadsDir = path.resolve(process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'));

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(uploadsDir));

app.use('/api/videos', videoRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
