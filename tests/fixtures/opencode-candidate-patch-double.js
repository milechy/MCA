#!/usr/bin/env node
const fs = require('node:fs');
const patch = `diff --git a/tests/opencode-generated.spec.js b/tests/opencode-generated.spec.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/tests/opencode-generated.spec.js
@@ -0,0 +1,3 @@
+const { test } = require('@playwright/test');
+test('generated candidate patch', () => {});
+
`;
fs.writeFileSync('candidate.patch', patch, 'utf8');
process.stdout.write('candidate.patch written\n');
