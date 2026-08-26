export function parseVitestJson(stdout, slug) {
  const reportLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"numTotalTestSuites":'));
  if (reportLines.length !== 1) {
    throw new Error(`${slug} emitted ${reportLines.length} Vitest JSON reports; expected exactly one`);
  }
  try {
    return JSON.parse(reportLines[0]);
  } catch (error) {
    throw new Error(`${slug} did not emit valid Vitest JSON: ${error.message}`);
  }
}
