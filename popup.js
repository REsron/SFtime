console.log('This is a popup!');

let apiVersion = localStorage.getItem("apiVersion") == null ? "61.0" : localStorage.getItem("apiVersion");
let timezone = '';
let sessionError;

// sfdcBody = normal Salesforce page
// ApexCSIPage = Developer Console
// auraLoadingBox = Lightning / Salesforce1
if (document.querySelector("body.sfdcBody, body.ApexCSIPage, #auraLoadingBox") || location.host.endsWith("visualforce.com")) {
    // We are in a Salesforce org
    chrome.runtime.sendMessage({message: "getSfHost", url: location.href}, sfHost => {
      if (sfHost) {
        initPage();
        timezone = localStorage.getItem(sfHost+"_timezone");
        if(timezone!=null && timezone!=''){
            initOrgClock();
        }
        console.log('timezone',timezone);
        console.log('sfHost',sfHost);
        if(sfHost!=null && sfHost!=''){
            getSession(sfHost);
        }    
      }
    });
  }

  function initPage(){
    let rootEl = document.createElement("div");
    rootEl.id = "org-clock";
    rootEl.style = 'z-index: 1000;display: block;position: fixed; vertical-align: middle;top:10px;left:0px;background-color:White';
    rootEl.innerHTML = 'Loading...';
    document.body.appendChild(rootEl);
  }

  function nullToEmptyString(value) {
    // For react input fields, the value may not be null or undefined, so this will clean the value
    return (value == null) ? "" : value;
  }


  async function getSession(sfHost) {
    sfHost = getMyDomain(sfHost);
    const ACCESS_TOKEN = "access_token";
    const currentUrlIncludesToken = window.location.href.includes(ACCESS_TOKEN);
    const oldToken = localStorage.getItem(sfHost + "_" + ACCESS_TOKEN);
    this.instanceHostname = sfHost;
    if (currentUrlIncludesToken){ //meaning OAuth flow just completed
      if (window.location.href.includes(ACCESS_TOKEN)) {
        const url = new URL(window.location.href);
        const hashParams = new URLSearchParams(url.hash.substring(1)); //hash (#) used in user-agent flow
        const accessToken = decodeURI(hashParams.get(ACCESS_TOKEN));
        sfHost = decodeURI(hashParams.get("instance_url")).replace(/^https?:\/\//i, "");
        this.sessionId = accessToken;
        localStorage.setItem(sfHost + "_" + ACCESS_TOKEN, accessToken);
      }
    } else if (oldToken) {
      this.sessionId = oldToken;
    } else {
      let message = await new Promise(resolve =>
        chrome.runtime.sendMessage({message: "getSession", sfHost}, resolve));
      if (message) {
        this.instanceHostname = getMyDomain(message.hostname);
        this.sessionId = message.key;
        console.log('Got the session IDDDD',this.sessionId);
      }
    }
    const IS_SANDBOX = "isSandbox";
    if (localStorage.getItem(sfHost + "_" + IS_SANDBOX) == null) {
        rest("/services/data/v" + apiVersion + "/query/?q=SELECT+IsSandbox,+InstanceName,+TimeZoneSidKey+FROM+Organization").then(res => {
        localStorage.setItem(sfHost + "_" + IS_SANDBOX, res.records[0].IsSandbox);
        localStorage.setItem(sfHost + "_orgInstance", res.records[0].InstanceName);
        localStorage.setItem(sfHost + "_timezone",res.records[0].TimeZoneSidKey);
        console.log('Time zone',res.records[0].TimeZoneSidKey);
        this.timezone = res.records[0].TimeZoneSidKey;
        if(this.timezone!=null && this.timezone!=''){
            console.log('this.timezone',this.timezone);
            initOrgClock();
        }
      });
    }else{
        console.log('rest is in progress');
        rest("/services/data/v" + apiVersion + "/query/?q=SELECT+IsSandbox,+InstanceName,+TimeZoneSidKey+FROM+Organization").then(res => {
            localStorage.setItem(sfHost + "_PROD", res.records[0].IsSandbox);
            localStorage.setItem(sfHost + "_orgInstance", res.records[0].InstanceName);
            localStorage.setItem(sfHost + "_timezone",res.records[0].TimeZoneSidKey);
            console.log('Time zone',res.records[0].TimeZoneSidKey);
            this.timezone = res.records[0].TimeZoneSidKey;
            if(this.timezone!=null && this.timezone!=''){
                console.log('this.timezone',this.timezone);
                initOrgClock();
            }
          });
    }
  }

  function getMyDomain(host) {
    if (host) {
      const myDomain = host
        .replace(/\.lightning\.force\./, ".my.salesforce.") //avoid HTTP redirect (that would cause Authorization header to be dropped)
        .replace(/\.mcas\.ms$/, ""); //remove trailing .mcas.ms if the client uses Microsoft Defender for Cloud Apps
      return myDomain;
    }
    return host;
  }

  async function rest(url, {logErrors = true, method = "GET", api = "normal", body = undefined, bodyType = "json", responseType = "json", headers = {}, progressHandler = null} = {}, rawResponse) {
    if (!this.instanceHostname) {
      throw new Error("Instance Hostname not found");
    }

    let xhr = new XMLHttpRequest();
    url += (url.includes("?") ? "&" : "?") + "cache=" + Math.random();
    const sfHost = "https://" + this.instanceHostname;
    xhr.open(method, sfHost + url, true);

    xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");

    if (api == "bulk") {
      xhr.setRequestHeader("X-SFDC-Session", this.sessionId);
    } else if (api == "normal") {
      xhr.setRequestHeader("Authorization", "Bearer " + this.sessionId);
    } else {
      throw new Error("Unknown api");
    }

    if (body !== undefined) {
      xhr.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
      if (bodyType == "json") {
        body = JSON.stringify(body);
      } else if (bodyType == "raw") {
        // Do nothing
      } else {
        throw new Error("Unknown bodyType");
      }
    }

    for (let [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    xhr.responseType = responseType;
    await new Promise((resolve, reject) => {
      if (progressHandler) {
        progressHandler.abort = () => {
          let err = new Error("The request was aborted.");
          err.name = "AbortError";
          reject(err);
          xhr.abort();
        };
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          resolve();
        }
      };
      xhr.send(body);
    });
    if (rawResponse){
      return xhr;
    } else if (xhr.status >= 200 && xhr.status < 300) {
      return xhr.response;
    } else if (xhr.status == 0) {
      if (!logErrors) { console.error("Received no response from Salesforce REST API", xhr); }
      let err = new Error();
      err.name = "SalesforceRestError";
      err.message = "Network error, offline or timeout";
      throw err;
    } else if (xhr.status == 401) {
      let error = xhr.response.length > 0 ? xhr.response[0].message : "New access token needed";
      //set sessionError only if user has already generated a token, which will prevent to display the error when the session is expired and api access control not configured
      if (localStorage.getItem(this.instanceHostname + "_access_token")){
        sessionError = error;
        showInvalidTokenBanner();
      }
      let err = new Error();
      err.name = "Unauthorized";
      err.message = error;
      throw err;
    } else {
      if (!logErrors) { console.error("Received error response from Salesforce REST API", xhr); }
      let err = new Error();
      err.name = "SalesforceRestError";
      err.detail = xhr.response;
      try {
        err.message = err.detail.map(err => `${err.errorCode}: ${err.message}${err.fields && err.fields.length > 0 ? ` [${err.fields.join(", ")}]` : ""}`).join("\n");
      } catch (ex) {
        err.message = JSON.stringify(xhr.response);
      }
      if (!err.message) {
        err.message = "HTTP error " + xhr.status + " " + xhr.statusText;
      }
      throw err;
    }
  }

  function showInvalidTokenBanner(){
    console.log('Invalid Tokeeen');
  }

  function getLiveOrgTime(timeZone) {
    // Create a clock that updates dynamically
    setInterval(() => {
        const now = new Date();

        // Convert the current time to the org's time zone
        const options = { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const orgTime = now.toLocaleString('en-US', options);

        // Display the time
        document.getElementById('org-clock').innerHTML = `Org Time (${timeZone}):</br> ${orgTime}`;
        //console.log(`Org Time (${timeZone}): ${orgTime}`);
    }, 1000);
}

// Main function to fetch time zone and start clock
async function initOrgClock() {
    const timeZone = this.timezone;
    console.log('The Time Zone is ',this.timezone);
    if (timeZone!='' && timeZone!=null) {
        getLiveOrgTime(timeZone);
    } else {
        document.getElementById('org-clock').innerHTML = 'Failed to fetch Org Time Zone';
        //console.log('Failed to fetch Org Time Zone')
    }
}