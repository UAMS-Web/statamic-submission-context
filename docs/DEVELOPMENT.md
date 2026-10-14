# Development loop against a host

The gate (`composer ci`) boots a minimal Statamic through Testbench. Behavior that depends on a real install (the add-on discovered through Composer, its Control Panel assets published, its routes served) needs a real Statamic host. This page is the loop for exercising the add-on in one, and the setup the `host-only-behavior-needs-a-host-run` rule and the `host-app-tests` skill assume once the add-on is onboarded to the sync.

## The host

Keep one persistent Statamic 6 host per developer machine, in the directory the local web server serves (Herd's, on the maintainers' machines), named for the add-on it serves:

```
statamic-addon-template-host
```

It is a stock `statamic/statamic` project with one change: `composer.json` carries a path repository pointing at the add-on checkout, and requires the add-on at `@dev`. Record any other change the add-on needs (for example, turning on multisite and defining two sites, if the add-on is about sites) in the host's own files, so it can be rebuilt from this page, and add that step to the list below.

## Rebuilding the host

Run these in the web server's directory. `<path-to-addon-checkout>` is the absolute path of the primary checkout or the slot being tested; it differs per machine, so it is written as a placeholder here.

```bash
composer create-project statamic/statamic statamic-addon-template-host
cd statamic-addon-template-host
composer config repositories.addon path "<path-to-addon-checkout>"
composer config minimum-stability dev
composer config prefer-stable true
composer require uams-web/statamic-addon-template:@dev
```

## Picking up a change

A path repository installs by symlink where the filesystem allows it, so an edit in the checkout is live in the host with no further step. Where a symlink cannot be created Composer copies instead, and a change then needs `composer reinstall uams-web/statamic-addon-template`. Check which one happened: `vendor/uams-web/statamic-addon-template` is a symlink to the checkout, or it is not.

To run the host against a worktree slot rather than the primary checkout, repoint that symlink and set it back afterwards. In PowerShell, from the host root, with the slot's absolute path in place of `<slot-path>`:

```powershell
$link = 'vendor\uams-web\statamic-addon-template'
[System.IO.Directory]::Delete($link, $false)                  # removes the link, not its target
New-Item -ItemType SymbolicLink -Path $link -Target '<slot-path>'
```

On macOS or Linux, `ln -sfn <slot-path> vendor/uams-web/statamic-addon-template` does the same.

The autoloader maps the add-on's namespace to that path, so a class added on the slot's branch loads with no `composer dump-autoload`. A change to `composer.json` (a new provider, a new `extra.statamic` key) needs `composer update uams-web/statamic-addon-template` from the host root, and the `Discovered Addon:` line at the end of the output confirms discovery.

## Confirming the add-on loaded

From the host root:

```bash
php artisan package:discover                      # lists uams-web/statamic-addon-template
php artisan tinker --execute='echo \Statamic\Facades\Addon::all()->map->package()->implode(",");'
```

Then request `/cp/addons` as a super user, in a browser or in process, and confirm the page lists the add-on with the version of the checked-out branch.

## Control Panel assets

`npm run build` writes the production build to `resources/dist`, which is committed. In the host, `php artisan vendor:publish --tag=statamic-addon-template --force` copies `resources/dist/build` to `public/vendor/statamic-addon-template/build`, and `statamic:install` does the same after a `composer update`. After publishing, the `/cp/addons` page references the built `cp-<hash>.js` and `cp-<hash>.css` under `/vendor/statamic-addon-template/build/assets/`. `npm ci` needs `vendor/statamic/cms`, because `@statamic/cms` is a `file:` link into it, so run `composer install` first.

## Editions can be added later

An add-on declares no editions by default. Whether it can gain `["free", "pro"]` after a public tag without disturbing installs was measured in a host by pointing the path repository at a copy of an add-on without editions and then at one with `extra.statamic.editions` set to `["free", "pro"]`, each followed by `composer update` and a read of `Addon::get('<package>')`.

| State | `editions()` | `edition()` |
| --- | --- | --- |
| No editions declared | empty | `null` |
| `["free", "pro"]` declared, nothing configured in the host | `["free", "pro"]` | `"free"` |
| `["free", "pro"]` declared, host config names `pro` | `["free", "pro"]` | `"pro"` |
| No editions declared, host config names `pro` | empty | throws `Invalid edition [pro]` |

So declaring editions later, with `free` first, leaves an install that never chose an edition on `free`: adding them is not breaking. The one failure is the host that names an edition for an add-on that declares none, which only a deliberate `config/statamic/editions.php` entry produces. `Addon::edition()` returns the configured edition, else the first declared one, which is why `free` must stay first. Measured on Windows 11 with `statamic/cms` v6.35.1 and PHP 8.4.20, for `statamic-multisite-forms`. macOS is not yet measured. The Marketplace side (whether the product's edition list must match at the first public tag) was not measured.

## Running the host-bound tests

`tests/Feature/` holds tests that extend the host's `Tests\TestCase`. They are not part of `composer ci`: the package has no `Feature` suite and PHPStan excludes the directory, because `Tests\TestCase` does not exist in this package. From the host root:

```bash
php artisan test vendor/uams-web/statamic-addon-template/tests/Feature/HostRegistersAddonTest.php
```

`HostRegistersAddonTest` asserts that the host lists the add-on and registers its service provider. Add a host-bound test for each behavior only a host exercises, and run the whole directory with `php artisan test vendor/uams-web/statamic-addon-template/tests/Feature/`. The `host-only-behavior-needs-a-host-run` rule says when a run is required, and the `host-app-tests` skill covers claiming a slot and reading results.

## Patch leakage

The add-on's dev patches for `pestphp/pest-plugin-mutate` must not touch the host, so they are declared in a root-only `patches.json`, never in `extra.patches`. Composer copies a package's `extra` block into the host's `composer.lock`, and `cweagans/composer-patches` reads `extra.patches` back out of it for every package the host requires, so a host running that plugin alongside `pest-plugin-mutate` would try to apply them. The plugin has no such path for a dependency's `patches.json`, and the file is left out of the dist archive.

## Platforms

The procedure above was measured on Windows 11 with PHP 8.4 for `statamic-multisite-forms`. The host would be created the same way under Herd on a Mac; whether the path repository symlinks there is expected but not measured. Record what you measure on each platform here.
