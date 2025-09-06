const fs = require('fs');
const path = require('path');

// Files to fix and their error corrections
const fixes = [
  // Fix error handling in all files
  {
    file: 'apps/api/src/common/services/batch-organizer.service.ts',
    replacements: [
      {
        from: `this.logger.error(\`Error organizando foto \${photo.photoId}: \${error.message}\`);`,
        to: `this.logger.error(\`Error organizando foto \${photo.photoId}: \${getErrorMessage(error)}\`);`
      },
      {
        from: `this.logger.error(\`Error copiando a carpeta organizada: \${error.message}\`);`,
        to: `this.logger.error(\`Error copiando a carpeta organizada: \${getErrorMessage(error)}\`);`
      },
      {
        from: `import { CloudinaryService } from './cloudinary.service';`,
        to: `import { CloudinaryService } from './cloudinary.service';\nimport { getErrorMessage } from '@shared/utils';`
      }
    ]
  },
  {
    file: 'apps/api/src/uploads/uploads.service.ts',
    replacements: [
      {
        from: `details: error.message,`,
        to: `details: getErrorMessage(error),`
      },
      {
        from: `error: error.message,`,
        to: `error: getErrorMessage(error),`
      },
      {
        from: `import { UserRole } from '@shared/types';`,
        to: `import { UserRole } from '@shared/types';\nimport { getErrorMessage } from '@shared/utils';`
      }
    ]
  }
];

// Apply fixes
fixes.forEach(fix => {
  const filePath = path.join(__dirname, fix.file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    fix.replacements.forEach(replacement => {
      content = content.replace(replacement.from, replacement.to);
    });
    
    fs.writeFileSync(filePath, content);
    console.log(`Fixed: ${fix.file}`);
  } else {
    console.log(`File not found: ${fix.file}`);
  }
});

console.log('All fixes applied!');