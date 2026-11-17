'use strict';

class BaseAuthStrategy {
  name: string;
  version: string;
  
  constructor(name: string, version: string) {
    this.name = name;
    this.version = version;
  }
  
  async canHandle(_page: any): Promise<boolean> { return false; }
  async authenticate(_page: any, _credentials: any): Promise<boolean> { return false; }
  async detectCaptcha(_page: any): Promise<boolean> { return false; }
  async solveCaptcha(_page: any): Promise<boolean> { return false; }
  
  get id(): string { return `${this.name}-v${this.version}`; }
}

module.exports = BaseAuthStrategy;
