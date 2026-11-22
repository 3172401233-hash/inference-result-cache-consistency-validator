#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateCacheConsistency } from './validator.js';

function usage() {
  console.error('用法: node src/cli.js <input.json> [--strict]');
  console.error('  --strict: 存在错误命中或版本风险时以退出码 1 结束');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }
  const strict = args.includes('--strict');
  const filePath = args.find((arg) => !arg.startsWith('--'));
  if (!filePath) {
    usage();
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    console.error(`读取或解析输入失败: ${error.message}`);
    process.exit(2);
  }

  const report = validateCacheConsistency(input);
  console.log(JSON.stringify(report, null, 2));

  if (strict && (report.summary.invalidHits > 0 || report.summary.versionRisks > 0)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
