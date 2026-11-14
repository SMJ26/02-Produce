import {mkdir, rename, rm} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'

interface MediaStorage {
  path(key: string): string
  create(key: string): Promise<string>
  publish(source: string, key: string): Promise<void>
  remove(key: string): Promise<void>
}

const root = resolve(/* turbopackIgnore: true */ process.env.MEDIA_ROOT || '.media')
export const media: MediaStorage = {
  path(key) {
    if (!/^[a-z0-9-]+(?:\/[a-z0-9.-]+)*$/u.test(key) || key.split('/').some(part => part === '..' || part === '.'))
      throw new Error('Invalid media key.')
    return resolve(root, key)
  },
  async create(key) {
    const path = this.path(key)
    await mkdir(path, {recursive: true})
    return path
  },
  async publish(source, key) {
    const destination = this.path(key)
    await mkdir(dirname(destination), {recursive: true})
    await rename(source, destination)
  },
  async remove(key) {
    await rm(this.path(key), {recursive: true, force: true})
  },
}
