#!/usr/bin/env node
/** 卸载 call-loop 的 LaunchAgent。用法：npm run uninstall:call */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LABEL = 'com.dogeheng.dsh-omni-call';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
try { fs.unlinkSync(PLIST); } catch {}
console.log(`已卸载 ${LABEL}`);
