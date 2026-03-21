import { test } from 'vitest';
import { getAllTools } from './packages/core/src/tools/registry.js';
import './packages/core/src/tools/ansible.js';
import './packages/core/src/tools/ssh.js';

test('infrastructure tools registered', () => {
    const tools = getAllTools();
    const ansible = tools.find(t => t.name === 'ansible_playbook');
    const ssh = tools.find(t => t.name === 'ssh_exec');
    
    if (!ansible) throw new Error('ansible missing');
    if (!ssh) throw new Error('ssh missing');
    console.log('Tools correctly registered.');
});
