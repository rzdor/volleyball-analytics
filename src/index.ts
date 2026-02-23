import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import videoRoutes from './routes/videoRoutes';
import { resolveUploadsDir } from './utils/uploads';

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = (() => {
  const requestedDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
  try {
    return resolveUploadsDir();
  } catch (error) {
    console.error(
      `Failed to initialize uploads directory at ${requestedDir}. Server will exit.`,
      error
    );
    process.exit(1);
  }
})();

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
