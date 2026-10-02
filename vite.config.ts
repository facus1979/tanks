import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // Los worktrees de los agentes viven en .claude/worktrees, cada uno con su index.html, su src y su
  // node_modules. Sin esto vite los recorre al buscar dependencias y los vigila, y el servidor de desarrollo
  // (capturas, net-test) arranca lento o recarga a mitad de camino.
  optimizeDeps: { entries: ['index.html'] },
  server: { watch: { ignored: ['**/.claude/**'] } },
})
