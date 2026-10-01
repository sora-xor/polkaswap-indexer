# Include only inside pi.soramitsu.io's existing HTTPS server block.
# The trailing slash strips /polkaswap-chatgpt/ before forwarding.
location ^~ /polkaswap-chatgpt/ {
  client_max_body_size 64k;
  access_log off;
  proxy_pass http://127.0.0.1:4380/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Connection "";
  proxy_set_header X-Forwarded-For "";
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_connect_timeout 5;
  proxy_read_timeout 60;
  proxy_send_timeout 60;
  proxy_redirect off;
  proxy_cache off;
  proxy_buffering off;
}
