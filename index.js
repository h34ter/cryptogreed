// index.js

import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import analyzeHandler from './api/analyze.js';

dotenv.config();
const app = express();
app.use(bodyParser.json());

app.post('/analyze', analyzeHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Crypto Risk Analyzer running at http://localhost:${PORT}`);
});
