import { execSync } from 'child_process';

export interface ProcessInfo {
    pid: number;
    name: string;
}

export function enumerateProcesses(): ProcessInfo[] {
    const stdout = execSync(
        'powershell -NoProfile -Command "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json"',
        { encoding: 'utf-8', timeout: 10000 },
    );
    const raw = JSON.parse(stdout);
    const arr: Array<{ Id: number; ProcessName: string }> = Array.isArray(raw) ? raw : [raw];
    return arr.map((p) => ({ pid: p.Id, name: p.ProcessName }));
}

export function findProcessByName(name: string): ProcessInfo[] {
    const lower = name.toLowerCase().replace(/\.exe$/i, '');
    return enumerateProcesses().filter((p) => p.name.toLowerCase() === lower);
}
