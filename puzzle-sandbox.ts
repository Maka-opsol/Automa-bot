'use strict';

const { log } = require('./logger');

class PuzzleSandbox {
  async solvePuzzle(_page: any, _base64Image: any) { 
    log('Puzzle solving is not yet implemented. Skipping puzzle.', 'WARN', 'puzzle');
    return null;
  }
}

module.exports = new PuzzleSandbox();
