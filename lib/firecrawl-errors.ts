export function isWebsiteLoadError(message: string) {
  return /ERR_(?:CONNECTION|NAME|TIMED_OUT|ADDRESS|SSL)|(?:ssl|tls).{0,40}(?:certificate|cert)|(?:certificate|cert).{0,40}(?:ssl|tls)|url failed to load|connection was closed unexpectedly|verify the url is correct and the website is accessible|all scraping engines failed to retrieve content from this url|website is blocking automated access|url is invalid or the page doesn't exist|target website/i.test(message);
}
