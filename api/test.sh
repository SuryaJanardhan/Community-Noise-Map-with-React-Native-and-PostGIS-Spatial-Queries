#!/bin/bash
set -e

echo "=== Running TypeScript Compile Check ==="
npx tsc --noEmit

echo "=== Running Jest Test Suite ==="
npm run test
