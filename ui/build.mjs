#!/usr/bin/env node

import { writeDashboard, writeReactDashboard } from './compiler.mjs'

await Promise.all([writeDashboard(), writeReactDashboard()])
