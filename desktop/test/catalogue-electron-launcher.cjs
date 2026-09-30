const { app } = require('electron');
app.whenReady().then(() => require('./.catalogue-harness/suite.cjs'));
