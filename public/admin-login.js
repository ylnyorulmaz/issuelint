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
    status.textContent=response.status===429
      ?"Too many login attempts. Try again later."
      :response.status===503?"Admin login is not configured yet."
      :"Invalid username or password.";
    password.value="";
  }catch{
    status.textContent="Unable to reach the server. Please try again.";
    password.value="";
  }finally{submit.disabled=false;}
});