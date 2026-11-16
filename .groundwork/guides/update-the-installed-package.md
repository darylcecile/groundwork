### Update the installed package

`groundwork update` resolves the repository's default-branch commit, reinstalls that exact revision through Bun, and invokes the updated installer. The distribution test installs one Git revision, adds a skill and changes the installer entry point in a newer revision, and verifies the update. Linked source checkouts refresh their current registrations while preserving local work.
