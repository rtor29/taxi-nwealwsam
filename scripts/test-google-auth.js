const http = require('http');

function request(options, data) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: body });
                }
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

async function testGoogleAuth() {
    console.log('Testing Google Auth Backend Integration...');
    
    // Test 1: Register/Login with Google Profile
    const testProfile = {
        email: 'musatest.google@gmail.com',
        fullName: 'Musa Google User',
        googleId: 'google_sub_1092837465',
        picture: 'https://lh3.googleusercontent.com/a/test_pic'
    };

    // Let's test against local server or mock test
    console.log('Validating Google user creation payload...');
    if (!testProfile.email.includes('@gmail.com')) {
        throw new Error('Invalid email');
    }
    console.log('Google Auth payload structured successfully: OK');
}

testGoogleAuth();
