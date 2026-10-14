# Packagist and Marketplace submission checklist

The real-world steps between a finished add-on and a listing on Packagist and the Statamic Marketplace. Copy this page into the add-on, strike the steps that do not apply, and record each step's outcome and date in the add-on's issue, not here.

Each step is marked **Person** when it needs someone with an account, or **Repo** when it is a change in the repository.

## Before anything is submitted

1. **Repo.** The README describes only what exists, and the features it lists are real. It states the PHP and `statamic/cms` floors, the install command, and links the license once there is one. `tests/Unit/ReadmeTest.php` pins these. Check the README again before submitting to the Marketplace.
2. **Repo.** `composer.json` is complete for a public package: `name`, `description`, `keywords`, `type` of `statamic-addon`, `authors`, `support`, `autoload`, `extra.statamic` (`name`, `description`) and `extra.laravel.providers`, plus `license` once it is decided (UAMS-Web/uams-statamic#3039). `tests/Unit/SubmissionReadinessTest.php` pins these; add `license` to its field list in the change that adds it to `composer.json`.
3. **Repo.** If the add-on has Control Panel assets, the built files are committed (`resources/dist`) and the `Built assets` job is green, because a Composer install does not run npm.
4. **Person.** The operator decides to submit, and to Packagist and the Marketplace separately. Record the decision in `docs/DECISIONS.md`.

## Packagist

5. **Person.** Submit the repository's URL at [packagist.org/packages/submit](https://packagist.org/packages/submit). The package name is the `name` in `composer.json`.
6. **Person.** Confirm the repository's Packagist webhook sends push events, so a pushed tag appears on Packagist without a manual update.

## First release

7. **Person.** Tag the first release. Releases follow the `cutting-releases` rule and the `writing-release-notes` skill, both synced into the add-on. The Marketplace lists versions from tags.

## Statamic Marketplace

Statamic's [submission guidelines](https://statamic.com/marketplace/submission-guidelines) apply to free products too. Before step 8, run the `marketplace-review` skill (`.claude/skills/marketplace-review/`) against the release being submitted, and fix what it finds.

8. **Person.** Create a statamic.com seller account (`https://statamic.com/creator/begin`). Decide whether it is personal or institutional before creating it.
9. **Person.** Bank details: the guide ties these to charging for an add-on, so a free listing is expected not to need them. Unverified.
10. **Person.** In the seller dashboard, create a product linked to the Packagist package, with a price, a description, and screenshots. The guidelines' Rule 10 accepts a usage example instead of screenshots, which the README's quick start can give. Products start as drafts and can be previewed before publishing.
11. **Person.** Publish the product only when the operator says so. Once published, the add-on appears on the Marketplace and in the Control Panel's Addons area.

## Unverified

- Whether a free listing needs bank details or a seller account type beyond the default.
- Whether the price, or the edition list, can change after the first public tag. See "Editions can be added later" in `docs/DEVELOPMENT.md` for the host side; the Marketplace side was not measured.
- Whether the Marketplace requires anything about the license beyond a declared one.

## Source

Statamic's guide, Building an Addon (Marketplace Submission and Editions), and the marketplace submission guidelines (revision 2026-09-14). Re-read the steps above against the live seller dashboard before step 8.
