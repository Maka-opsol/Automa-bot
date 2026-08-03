module.exports = {
  mockVisionResponse: (action = { actionType: 'wait', currentState: 'mock', targetX: 0.5, targetY: 0.5 }) => {
    return async (base64Image, prompt, signal, options) => {
      return JSON.stringify(action);
    };
  },
  mockProvider: (name, response) => {
    return { name, fn: async (base64Image, prompt, signal, options) => response };
  },
  resetMocks: () => {}
};
