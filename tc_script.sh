#!/bin/bash
npx tsc --noEmit > /tmp/tc_result.txt 2>&1
echo "exit=$?" >> /tmp/tc_result.txt
