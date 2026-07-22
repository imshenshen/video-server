module.exports = {
  apps: [
    {
      name: "video-server",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "2G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
