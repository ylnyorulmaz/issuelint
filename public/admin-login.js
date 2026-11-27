/* No credentials are stored in cookies readable by JS or browser storage. */
const form=document.querySelector("#admin-login");
const submit=document.querySelector("#login-submit");
const status=document.querySelector("#login-message");
form?.addEventListener("submit",async event=>{
  event.preventDefault();
  if(!(form instanceof HTMLFormElement)||!(submit instanceof HTMLButtonElement)||!status)return;
  const username=form.querySelector("#username");
  const password=form.querySelector("#password");
  if(!(username instanceof HTMLInputElement)||!(password instanceof HTMLInputElement))return;
  const name=username.value.trim();
  const pass=password.value;
  if(!name||!pass)return;
  submit.disabled=true;
  status.textContent="";
  try{
    const response=await fetch("/api/admin/login",{
      method:"POST",
      credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:name,password:pass}),
      cache:"no-store"
    });
    if(response.ok){password.value="";window.location.replace("/admin");return;}
    status.textContent=response.status===401
      ?"Invalid username or password."
      :response.status===429?"Too many login attempts. Try again in a minute."
      :response.status===403?"Sign-in request blocked. Reload the page and retry."
      :response.status===503?"Admin login is temporarily unavailable. Please retry."
      :response.status>=500?"Server error during sign-in. Please try again."
      :"Unable to sign in. Please retry.";
    password.value="";
  }catch{
    status.textContent="Unable to reach the server. Please try again.";
    password.value="";
  }finally{submit.disabled=false;}
});