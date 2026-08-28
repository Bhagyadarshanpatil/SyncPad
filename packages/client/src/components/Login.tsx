import { GoogleLogin } from '@react-oauth/google'
import { jwtDecode } from 'jwt-decode'
import { useStore } from '../store'

export function Login() {
  const { setUser } = useStore()

  const handleSuccess = (credentialResponse: any) => {
    if (credentialResponse.credential) {
      const decoded: any = jwtDecode(credentialResponse.credential)
      const user = {
        id: decoded.sub,
        name: decoded.name,
        picture: decoded.picture,
        token: credentialResponse.credential,
      }
      setUser(user)
      localStorage.setItem('syncpad:user', JSON.stringify(user))
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-gray-50">
      <div className="p-8 bg-white shadow-xl rounded-xl border border-gray-100 flex flex-col items-center gap-6 text-center max-w-sm">
        <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center text-white font-bold text-3xl shadow-md">
          S
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome to SyncPad</h1>
          <p className="text-sm text-gray-500">Sign in to collaborate on documents in real-time.</p>
        </div>
        <GoogleLogin
          onSuccess={handleSuccess}
          onError={() => {
            console.error('Login Failed')
          }}
          useOneTap
        />
      </div>
    </div>
  )
}
