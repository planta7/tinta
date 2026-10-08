# Bounded Markdown tokenizer

`micromark@4.0.3.patch` adds an optional internal `observeTokenizer` callback to the locked parser, in both production and development entry points. It reports each state-machine transition before execution and each token entry before allocation. The syntax package uses this to enforce its shared compile-operation budget and incremental Markdown container-depth ceiling. No source-controlled callback, grammar change, runtime IO or new dependency version is introduced.

The patch is recorded by hash in the lockfile. Frozen installation applies it to the official package whose integrity and license remain in the dependency inventory. The complete official CommonMark corpus runs against this patched parser, and budget exhaustion is tested in both source profiles. Removing the hook would fail the ordinary-Markdown operation-budget regression.
