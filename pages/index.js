import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { default: CryptoRiskAnalyzer } = require('./api/analyze.js');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const analyzer = new CryptoRiskAnalyzer();

app.use(bodyParser.json());

app.post('/analyze', async (req, res) => {
  const { coinId, contractAddress, chain, clientId } = req.body;
  const result = await analyzer.analyze(coinId, contractAddress, chain, clientId || 'default');
  res.status(result.error ? 400 : 200).json(result);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
