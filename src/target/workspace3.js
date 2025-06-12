const validateActionInput = require('../util/validateActionInput');
const validateNotOutsideWorkingDir = require('../util/validate/validateNotOutsideWorkingDir');
const validateNotEmpty = require('../util/validate/validateNotEmpty');
const { v4: uuidv4 } = require('uuid');
const open = require('open');
const path = require('path');
const fs = require('fs');
const globPromise = require('glob-promise');
const cliProgress = require('cli-progress');
const mime = require('mime-types');
const archiver = require('archiver');

// Validate UUID format
const validateUUID = (input) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(input) || 'Please enter a valid UUID format';
};

// Validate email format
const validateEmail = (input) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(input) || 'Please enter a valid email address';
};

const workspace3 = {
  // ===========================================
  // QUESTIONS
  // ===========================================
  questions: [
    {
      type: 'input',
      name: 'email',
      message: 'Please fill in your Workspace3 email:',
      default: process.env.WS3_EMAIL,
      errorMessage: 'Missing email',
      validate: validateEmail,
      required: true,
      save: false, 
    },
    {
      type: 'password',
      name: 'password',
      message: 'Please fill in your Workspace3 password:',
      default: process.env.WS3_PASSWORD,
      errorMessage: 'Missing password',
      validate: validateNotEmpty,
      required: true,
      mask: '*',
      save: false, 
    },
    {
      type: 'input',
      name: 'folderId',
      message: 'Please fill in the Workspace3 folder ID:',
      default: process.env.WS3_FOLDER_ID,
      errorMessage: 'Missing folder ID',
      validate: validateUUID,
      required: true,
    },
    {
      type: 'input',
      name: 'host',
      message: 'Please fill in the Workspace3 host (or press Enter for default):',
      default: process.env.WS3_HOST || 'workspace.monks.tools',
      validate: validateNotEmpty,
      required: true,
    },
    {
      type: 'confirm',
      name: 'addComments',
      message: 'Would you like to add a comment after file upload?',
      save: false,
    },
    {
    type: 'input',
    name: 'commentText',
    message: 'Enter your comment (leave empty for default message):',
    when: (answers) => answers.addComments
    }
  ],

  // ===========================================
  // WORKSPACE3 API CLIENT FACTORY
  // ===========================================
  createAPIClient(options) {
    const baseUrl = `https://${options.host}`;
    let accessToken = null;
    
    return {
      async authenticate() {
        const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: options.email,
            password: options.password
          })
        });

        if (!response.ok) {
          let errorMessage = `Authentication failed: ${response.status} ${response.statusText}`;
          
          try {
            const errorData = await response.text();
            if (errorData) {
              console.log('Response body:', errorData);
              errorMessage += ` - ${errorData}`;
            }
          } catch (e) {
            console.log('Could not read error response body');
          }
          
          throw new Error(errorMessage);
        }

        const data = await response.json();
        accessToken = data.accessToken;
        return data;
      },

      async generateUploadUrl(filename) {
        const response = await fetch(`${baseUrl}/api/v1/uploadUrls/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/vnd.api+json'
          },
          body: JSON.stringify({
            data: {
              type: 'uploadUrl',
              attributes: {
                uploadType: 'asset',
                fileName: filename
              },
              relationships: {
                folder: {
                  data: {
                    type: 'folder',
                    id: options.folderId
                  }
                }
              }
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to generate upload URL: ${response.statusText}`);
        }

        const data = await response.json();
        return {
          url: data.data.attributes.url,
          path: data.data.attributes.path,
          asset: data.data.relationships.asset.data
        };
      },

      async uploadToS3(filePath, uploadUrl) {
        const fileData = fs.readFileSync(filePath);
        const contentType = mime.lookup(filePath) || 'application/octet-stream';

        const response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': contentType
          },
          body: fileData
        });

        if (!response.ok) {
          throw new Error(`S3 upload failed: ${response.statusText}`);
        }
      },

      async registerAssetVersion(uploadData, filename) {
        const response = await fetch(`${baseUrl}/api/v1/assetVersions/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/vnd.api+json'
          },
          body: JSON.stringify({
            data: {
              type: 'assetVersion',
              attributes: {
                uploadPath: uploadData.path,
                filename: filename
              },
              relationships: {
                asset: {
                  data: {
                    type: 'asset',
                    id: uploadData.asset.id
                  }
                },
                folder: {
                  data: {
                    type: 'folder',
                    id: options.folderId
                  }
                }
              }
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to register asset version: ${response.statusText}`);
        }

        const data = await response.json();
        return data.data;
      },

      async addComment(assetVersionId, message) {
        const response = await fetch(`${baseUrl}/api/v1/comments/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/vnd.api+json'
          },
          body: JSON.stringify({
            data: {
              type: 'comment',
              attributes: {
                message
              },
              relationships: {
                assetVersion: {
                  data: {
                    type: 'assetVersion',
                    id: assetVersionId
                  }
                }
              }
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to add comment: ${response.statusText}`);
        }

        return await response.json();
      }
    };
  },

  // ===========================================
  // BANNER DETECTION FUNCTIONS
  // ===========================================
  
  /**
   * Detect banner folders in the input directory
   * Identifies folders containing index.html and filters out React app files
   */
  async detectBannerFolders(inputDir) {
    const folders = [];
    const items = await fs.promises.readdir(inputDir, { withFileTypes: true });
    
    for (const item of items) {
      if (item.isDirectory()) {
        const folderPath = path.join(inputDir, item.name);
        const indexPath = path.join(folderPath, 'index.html');
        
        // Check if folder contains index.html
        if (fs.existsSync(indexPath)) {
          // Additional check: size pattern (e.g., 300x250)
          const sizePattern = /\d+x\d+/;
          const hasSize = sizePattern.test(item.name);
          
          // Check if it's not a React app folder
          const isReactApp = await this.isReactAppFolder(folderPath);
          
          if (!isReactApp) {
            folders.push({
              name: item.name,
              path: folderPath,
              hasSize: hasSize
            });
          }
        }
      }
    }
    
    return folders;
  },

  /**
   * Check if a folder is a React application folder
   */
  async isReactAppFolder(folderPath) {
    // Check for typical React app files/folders
    const reactIndicators = [
      'static',           // Common React build folder
      'manifest.json',    // React app manifest
      'asset-manifest.json', // Create React App manifest
    ];
    
    for (const indicator of reactIndicators) {
      const indicatorPath = path.join(folderPath, indicator);
      if (fs.existsSync(indicatorPath)) {
        return true;
      }
    }
    
    // Check if index.html contains React-specific patterns
    const indexPath = path.join(folderPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = await fs.promises.readFile(indexPath, 'utf8');
      // Look for React app patterns
      if (content.includes('react') || content.includes('static/js/') || content.includes('static/css/')) {
        return true;
      }
    }
    
    return false;
  },

  /**
   * Extract version number from asset version response
   * Tries to get it from the response or generates a timestamp-based number
   */
  extractVersionNumber(assetVersion) {
    // Try to extract version from the response
    if (assetVersion && assetVersion.attributes) {
      // Look for version in various possible fields
      if (assetVersion.attributes.version) {
        return assetVersion.attributes.version;
      }
      if (assetVersion.attributes.versionNumber) {
        return assetVersion.attributes.versionNumber;
      }
      // Sometimes version is just the ID
      if (assetVersion.id) {
        // Extract number from ID if it contains one
        const match = assetVersion.id.match(/\d+$/);
        if (match) return match[0];
      }
    }
    
    // Fallback: generate version based on timestamp
    const now = new Date();
    const timestamp = now.getFullYear().toString().slice(-2) + 
                     String(now.getMonth() + 1).padStart(2, '0') + 
                     String(now.getDate()).padStart(2, '0') + 
                     String(now.getHours()).padStart(2, '0') + 
                     String(now.getMinutes()).padStart(2, '0');
    return timestamp;
  },


  // ===========================================
  // ZIP CREATION FUNCTIONS
  // ===========================================
  
  /**
   * Create a ZIP file from banner folder contents
   * Compresses files inside the banner folder, not the folder itself
   */
  async createBannerZip(bannerFolder, tempDir) {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(tempDir, `${bannerFolder.name}.zip`);
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        resolve(outputPath);
      });
      
      archive.on('error', (err) => {
        reject(err);
      });
      
      archive.pipe(output);
      
      // Add all files from the banner folder
      // Using directory with false as second param to not include the folder itself
      archive.directory(bannerFolder.path, false);
      
      archive.finalize();
    });
  },

  /**
   * Clean up temporary files and directories
   */
  async cleanupTempFiles(tempDir) {
    try {
      await fs.promises.rm(tempDir, { recursive: true });
    } catch (error) {
      console.warn(`Warning: Could not clean up temp directory: ${error.message}`);
    }
  },

  // ===========================================
  // MAIN ACTION FUNCTION
  // ===========================================
  async action(data) {
    validateActionInput(data, this.questions);

    // Create API client
    const apiClient = this.createAPIClient(data);

    // Authenticate with Workspace3
    console.log('🔐 Authenticating with Workspace3...');
    await apiClient.authenticate();
    console.log('✅ Authentication successful');

    // Detect banner folders
    console.log('🔍 Detecting banner folders...');
    const bannerFolders = await this.detectBannerFolders(data.inputDir);
    
    if (bannerFolders.length === 0) {
      console.log('❌ No banner folders detected (folders with index.html)');
      console.log('Make sure your input directory contains banner folders with index.html files');
      console.log('React app folders are automatically filtered out');
      return;
    }
    
    console.log(`📁 Found ${bannerFolders.length} banner folders:`);
    bannerFolders.forEach(folder => {
      console.log(`   - ${folder.name} ${folder.hasSize ? '(has size in name)' : ''}`);
    });

    // Create temporary directory for ZIP files
    const tempDir = path.join(__dirname, '..', '..', 'temp', uuidv4());
    await fs.promises.mkdir(tempDir, { recursive: true });

    try {
      // Create ZIP files for each banner
      console.log('📦 Creating ZIP files for banners...');
      const zipProgress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
      zipProgress.start(bannerFolders.length, 0);

      const zipFiles = [];
      for (const folder of bannerFolders) {
        try {
          const zipPath = await this.createBannerZip(folder, tempDir);
          zipFiles.push({
            originalFolder: folder,
            zipPath: zipPath,
            name: `${folder.name}.zip`
          });
        } catch (error) {
          console.error(`❌ Error creating ZIP for ${folder.name}: ${error.message}`);
        }
        zipProgress.increment();
      }
      zipProgress.stop();

      if (zipFiles.length === 0) {
        console.log('❌ No ZIP files created successfully');
        return;
      }

      console.log(`📤 Uploading ${zipFiles.length} banner ZIP files to Workspace3...`);

      // Progress bar setup for uploads
      const uploadProgress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
      uploadProgress.start(zipFiles.length, 0);

      const uploadResults = [];

      // Upload ZIP files
      await Promise.all(
        zipFiles.map(async ({ originalFolder, zipPath, name }) => {
          try {
            // 1. Generate upload URL
            const uploadData = await apiClient.generateUploadUrl(name);
            
            // 2. Upload to S3
            await apiClient.uploadToS3(zipPath, uploadData.url);
            
            // 3. Register asset version
            const assetVersion = await apiClient.registerAssetVersion(uploadData, name);
            
            // 4. Add comment if enabled
            if (data.addComments) {
                console.log(`📝 Adding comment for ${name}`);
                const defaultComment = `${name} uploaded via Display-Upload Tool`;
                
                // More explicit comment text handling
                const commentText = typeof data.commentText === 'string' && data.commentText.trim() 
                    ? data.commentText.trim() 
                    : defaultComment;
                
                await apiClient.addComment(assetVersion.id, commentText);
            }

            uploadResults.push({
              folder: originalFolder.name,
              zipPath,
              success: true,
              assetId: uploadData.asset.id,
              assetVersionId: assetVersion.id,
              previewUrl: `https://${data.host}/preview/asset/${uploadData.asset.id}`
            });
          } catch (error) {
            console.error(`❌ Error uploading ${name}: ${error.message}`);
            uploadResults.push({
              folder: originalFolder.name,
              zipPath,
              success: false,
              error: error.message
            });
          }
          uploadProgress.increment();
        })
      );

      uploadProgress.stop();

      // Summary
      const successCount = uploadResults.filter(r => r.success).length;
      console.log(`\n✅ Upload completed: ${successCount}/${zipFiles.length} banners successful`);

      // Show errors if any
      const errors = uploadResults.filter(r => !r.success);
      if (errors.length > 0) {
        console.log('\n❌ Failed uploads:');
        errors.forEach(result => {
          console.log(`- ${result.folder}: ${result.error}`);
        });
      }

    } finally {
      // Clean up temporary files
      console.log('\n🧹 Cleaning up temporary files...');
      await this.cleanupTempFiles(tempDir);
    }
  },
};

module.exports = workspace3;