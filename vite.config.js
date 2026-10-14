import { defineConfig } from 'vite'
import laravel from 'laravel-vite-plugin'
import statamic from '@statamic/cms/vite-plugin'

// Builds the add-on's Control Panel assets (#15). The `input` and `publicDirectory` here must
// match the `$vite` property on `src/ServiceProvider.php`; Statamic reads the manifest this
// writes to find the hashed files. The output is committed, because a Composer install does
// not run npm.
export default defineConfig({
    plugins: [
        statamic(),
        laravel({
            input: ['resources/js/cp.js', 'resources/css/cp.css'],
            publicDirectory: 'resources/dist',
        }),
    ],
})
