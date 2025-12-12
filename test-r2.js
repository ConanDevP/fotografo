// Test R2 connection
// Run with: node test-r2.js

require('dotenv').config();

const { S3Client, ListBucketsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

async function testR2() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME || 'fotografos-images';

    console.log('=== R2 Configuration ===');
    console.log('Account ID:', accountId ? `${accountId.substring(0, 8)}...` : 'NOT SET');
    console.log('Access Key ID:', accessKeyId ? `${accessKeyId.substring(0, 8)}...` : 'NOT SET');
    console.log('Secret Access Key:', secretAccessKey ? 'SET (hidden)' : 'NOT SET');
    console.log('Bucket Name:', bucketName);
    console.log('Endpoint:', `https://${accountId}.r2.cloudflarestorage.com`);
    console.log('');

    if (!accountId || !accessKeyId || !secretAccessKey) {
        console.error('❌ Missing R2 credentials in .env file');
        process.exit(1);
    }

    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });

    console.log('=== Testing Connection ===');

    // Test 1: List buckets
    try {
        console.log('1. Listing buckets...');
        const listResult = await client.send(new ListBucketsCommand({}));
        console.log('   ✅ Connection successful!');
        console.log('   Buckets:', listResult.Buckets?.map(b => b.Name).join(', ') || 'none');
    } catch (error) {
        console.error('   ❌ Failed to list buckets:', error.message);
        console.error('   Full error:', error);
    }

    // Test 2: Upload small test file
    try {
        console.log('2. Uploading test file...');
        const testKey = `test/connection-test-${Date.now()}.txt`;
        const testContent = `R2 connection test at ${new Date().toISOString()}`;

        await client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: testKey,
            Body: Buffer.from(testContent),
            ContentType: 'text/plain',
        }));

        console.log('   ✅ Upload successful!');
        console.log('   Key:', testKey);
    } catch (error) {
        console.error('   ❌ Failed to upload:', error.message);
        if (error.message.includes('SSL') || error.message.includes('EPROTO')) {
            console.error('   ⚠️  This is an SSL/TLS error. Possible causes:');
            console.error('      - Invalid credentials');
            console.error('      - Wrong account ID');
            console.error('      - Network/firewall issue');
        }
    }
}

testR2().catch(console.error);
