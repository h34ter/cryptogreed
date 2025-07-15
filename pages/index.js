const express = require('express');
const bodyParser = require('body-parser');
const analyzerModule = require('./api/analyze.js');

const app = express();
app.use(bodyParser.json());

const analyzer = new analyzerModule();

app.post('/analyze', async (req, res) => {
  const { coinId, contractAddress, chain, clientId } = req.body;
  const result = await analyzer.analyze(coinId, contractAddress, chain, clientId || 'default');
  if (result.error) return res.status(400).json(result);
  res.status(200).json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
