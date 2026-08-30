import { validatePackageInput } from './final-recertification-package-lib.mjs'

const index = process.argv.indexOf('--input')
const input = index >= 0 ? process.argv[index + 1] : undefined
const result = input
  ? validatePackageInput(input)
  : { status: 'FAIL', errors: ['Usage: validate-final-recertification-package.mjs --input <directory-or-zip>'] }

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (result.status !== 'PASS') process.exitCode = 1
