import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function hasGradleBuildMarkers(projectRoot: string | undefined): boolean {
  if (!projectRoot) {
    return false;
  }
  return [
    'settings.gradle',
    'settings.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
    'gradlew',
    'gradlew.bat',
    'app/build.gradle',
    'app/build.gradle.kts',
  ].some(relativePath => existsSync(join(projectRoot, relativePath)));
}

export function isAndroidSourceOnlyWorkspace(projectRoot: string | undefined): boolean {
  if (!projectRoot || hasGradleBuildMarkers(projectRoot)) {
    return false;
  }
  return [
    join(projectRoot, 'app', 'src', 'main', 'java'),
    join(projectRoot, 'app', 'src', 'main', 'kotlin'),
  ].some(path => existsSync(path));
}
