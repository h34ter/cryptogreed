// index.js
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const CryptoRiskAnalyzer = require('./api/analyze.js'); // adjust if needed

dotenv.config();
const app = express();
const analyzer = new CryptoRiskAnalyzer();

app.use(bodyParser.json());

app.post('/api/analyze', async (req, res) => {
  const { coinId, contractAddress, chain, clientId } = req.body;
  const result = await analyzer.analyze(coinId, contractAddress, chain, clientId || 'default');
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
