import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function publishProject(root) {
  const run = async args => (await exec('git',args,{cwd:root,maxBuffer:2_000_000})).stdout.trim();
  const branch = await run(['branch','--show-current']);
  if (!branch || branch==='HEAD') throw new Error('Initialize this directory as a Git repository and check out a named branch.');
  if (branch !== 'main') throw new Error('Check out the main branch before publishing; GitHub Pages deploys pushes to main.');
  if (!(await run(['remote','get-url','origin']))) throw new Error('Add a GitHub repository as the origin remote before publishing.');
  if (!(await run(['status','--porcelain']))) throw new Error('There are no local changes to publish.');
  await run(['add','--','.']);
  await run(['commit','-m','Update Huda Store catalog']);
  const result=await exec('git',['push','-u','origin',branch],{cwd:root,maxBuffer:2_000_000});
  return (result.stdout+result.stderr).trim() || 'Changes pushed to GitHub. GitHub Actions will deploy the Pages site.';
}
