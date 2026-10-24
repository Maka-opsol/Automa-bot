const { describe, expect, it } = require("vitest");
const pixelFallback = require("./pixel-fallback.ts");

function splashLikePixels(width = 400, height = 300) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = 24 + Math.floor(x / width * 20);
      rgba[idx + 1] = 102 - Math.floor(x / width * 50);
      rgba[idx + 2] = 180 - Math.floor(x / width * 35);
      rgba[idx + 3] = 255;
    }
  }
  for (let y = 140; y < 160; y++) for (let x = 190; x < 210; x++) {
    const idx = (y * width + x) * 4;
    rgba[idx] = rgba[idx + 1] = rgba[idx + 2] = 255;
  }
  return rgba;
}

describe("MathU splash guard", () => {
  it("distinguishes the blue loading splash from a video player", () => {
    const rgba = splashLikePixels();
    expect(pixelFallback._isMathUSplashByPixels(rgba, 400, 300)).toBe(true);
    expect(pixelFallback._isVideoPlayerByPixels(rgba, 400, 300)).toBe(false);
    expect(pixelFallback._classifyPageByColor(rgba, 400, 300)).toBe("mathu_splash");
  });
});